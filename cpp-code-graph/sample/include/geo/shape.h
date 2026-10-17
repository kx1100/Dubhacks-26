#pragma once
#include <string>
#include <memory>

namespace geo {

struct Point {
    double x = 0, y = 0;
};

/// Base class of every drawable shape.
class Shape {
public:
    explicit Shape(std::string name);
    virtual ~Shape() = default;

    virtual double area() const = 0;
    virtual void draw(class Canvas& canvas) const;
    const std::string& name() const { return name_; }

protected:
    Point origin_;

private:
    std::string name_;
};

class Circle : public Shape {
public:
    Circle(Point c, double r);
    double area() const override;
    void draw(Canvas& canvas) const override;
private:
    double radius_;
};

class Rectangle final : public Shape {
public:
    Rectangle(Point topLeft, double w, double h)
        : Shape("rect"), w_(w), h_{h} { origin_ = topLeft; }
    double area() const override { return w_ * h_; }
private:
    double w_, h_;
};

std::unique_ptr<Shape> makeShape(const std::string& kind);

} // namespace geo
